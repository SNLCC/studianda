import { createHash } from 'node:crypto';

/**
 * 选区冻结快照：用户带选中原文提问时，把选区落成**不可变**记录。
 *
 * 为什么需要：证据核验是「逐字回原文匹配 + 页码回链」。若之后 OCR 重跑或页校订改写，
 * 旧回答的证据就对不上原文；只按“缺证”展示会让用户分不清“模型编的”还是“原文变了”。
 * 有了快照，核验不过时可以再检查“提问时的选区文字还在不在当前页文本里”，
 * 不在就归因为「原文已变更」（`source_changed`），而不是「证据不足」。
 *
 * 这里只放纯函数与类型；持久化在 `store.ts` 的 `selection_snapshots` 表。
 */

/** 一条选区快照（不可变：写入后不更新，原文变化只会产生新 revision 的新快照）。 */
export interface SelectionSnapshotRecord {
  id: string;
  documentId: string;
  /** 选区所在页（1 基）；0 = 未能定位到具体页。 */
  page: number;
  /** 提问时用户选中的原文（首尾裁剪；比较时按空白归一化）。 */
  text: string;
  /** `text` 的 sha256（十六进制），用于去重/校验。 */
  textHash: string;
  /** 提问时该页文本的内容版本（页文本 sha256）；原文改写后与新页的 revision 不同。 */
  revision: string;
  /** 触发快照的问题（便于溯源，可为空）。 */
  question: string;
  created: string;
}

export type SelectionSnapshotStatus = 'current' | 'source_changed' | 'unknown';

/**
 * 空白归一化：去掉所有空白字符再比较。
 *
 * 选区来自页文本，但 OCR 重排/换行差异不应被当成“原文变更”；真正改写会改掉字符本身。
 */
export function normalizeSnapshotText(text: string | null | undefined): string {
  return String(text ?? '').replace(/\s+/g, '');
}

/** 选区文本的稳定指纹（空白归一化后的 sha256）。 */
export function snapshotTextHash(text: string | null | undefined): string {
  return createHash('sha256').update(normalizeSnapshotText(text), 'utf8').digest('hex');
}

/** 页面文本的内容版本（sha256）：页校订/OCR 重跑后必然变化。 */
export function pageTextRevision(pageText: string | null | undefined): string {
  return createHash('sha256')
    .update(String(pageText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
    .digest('hex');
}

/** 快照文字是否仍在当前页文本里（空白归一化后包含）。 */
export function snapshotStillPresent(
  snapshotText: string | null | undefined,
  currentPageText: string | null | undefined
): boolean {
  const needle = normalizeSnapshotText(snapshotText);
  if (!needle) return false;
  return normalizeSnapshotText(currentPageText).includes(needle);
}

/** 快照相对当前页文本的状态：命中 / 原文已变更 / 无法判定（快照没有页号）。 */
export function selectionSnapshotStatus(
  snapshot: Pick<SelectionSnapshotRecord, 'text' | 'page'>,
  currentPageText: string | null | undefined
): SelectionSnapshotStatus {
  if (!snapshot.page || snapshot.page <= 0) return 'unknown';
  return snapshotStillPresent(snapshot.text, currentPageText) ? 'current' : 'source_changed';
}

/** 核验/审计结论所需的最小字段（与 `AuditClaim` 结构兼容，避免循环依赖）。 */
export interface EvidenceStatusClaim {
  claim: number;
  verdict: string;
  evidence_status?: 'source_changed';
  evidence?: Array<{ page?: number }>;
}

/**
 * 在“验不过”的论断上增加归因：不改变原 verdict（缺证仍是缺证），只标注原文已变更。
 *
 * 规则（刻意保守，不改逐字核验逻辑）：
 * - 只处理 `verdict === 'unsupported'`（缺证）的论断；
 * - 只有快照文字**确实已不在**当前页文本里时，才标 `evidence_status: 'source_changed'`；
 * - 快照文字仍在（或没有快照/页号）时保持原样——普通缺证仍是普通缺证。
 *
 * 返回新的 claims 数组与被标注的论断编号，调用方可据此提示“原文已变更，非模型编造”。
 */
export function attributeUnsupportedClaims<T extends EvidenceStatusClaim>(
  claims: readonly T[],
  snapshotText: string | null | undefined,
  currentPageText: string | null | undefined,
  options: { page?: number } = {}
): { claims: T[]; sourceChangedClaims: number[] } {
  const needle = normalizeSnapshotText(snapshotText);
  if (!needle || currentPageText == null) {
    return { claims: [...claims], sourceChangedClaims: [] };
  }
  const pageText = normalizeSnapshotText(currentPageText);
  if (pageText.includes(needle)) {
    return { claims: [...claims], sourceChangedClaims: [] };
  }
  /** 归因只给“和选区同页有关”的缺证：不同页且证据明确的缺证不该被说成原文变更。 */
  const relatesToSnapshotPage = (claim: T): boolean => {
    const page = options.page;
    if (!page || page <= 0) return true;
    const evidence = claim.evidence ?? [];
    if (evidence.length === 0) return true;
    return evidence.some((item) => item.page === page);
  };
  const sourceChangedClaims: number[] = [];
  const attributed = claims.map((claim) => {
    if (claim.verdict !== 'unsupported' || !relatesToSnapshotPage(claim)) return claim;
    sourceChangedClaims.push(claim.claim);
    return { ...claim, evidence_status: 'source_changed' as const };
  });
  return { claims: attributed, sourceChangedClaims };
}
