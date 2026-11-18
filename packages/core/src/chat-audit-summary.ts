/**
 * 审计摘要的压缩、序列化与**容错**解析（schema_version 24）。
 *
 * 背景：跨篇会话的追问结果只把正文写进 `messages`，重开历史时会丢失「缺证 / 原文已变更 /
 * 越界引用」这些审计信息。这里把一轮 ChatResponse 里的审计结果压成**只含计数、编号与状态**的
 * `ChatAuditSummary`，随 assistant 消息落进 `messages.audit_summary`；读取时解析回对象挂在
 * 消息记录上。**不存正文/原文/完整 ChatResponse**，避免库膨胀与重复存储。
 *
 * 越界引用除计数外还存具体编号（回答正文里的 `[n]`），但有条数上限，避免摘要膨胀。
 * 解析必须容错：坏 JSON、字段缺失或类型不对都退化为「没有摘要」，绝不能让整条历史读取报错；
 * 迁移前的老摘要只有计数、没有编号数组，同样必须按「无编号」正常降级。
 */
import type { ChatAuditSummary } from '@studianda/shared';

type RecordLike = Record<string, unknown>;

/** 摘要里最多存多少个越界引用编号：超过只保留最小的若干个，计数仍如实记全量。 */
export const MAX_AUDIT_INVALID_CITATION_IDS = 20;

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 非负整数计数；其它值（负数/小数/字符串/NaN）一律视为无效。 */
function countOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function countOrZero(value: unknown): number {
  return countOf(value) ?? 0;
}

/** 论断类型计数：只保留正整数值，坏值丢弃而不是让整条摘要失效。 */
function claimTypesOf(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const counts: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const count = countOf(raw);
    if (count !== null && count > 0) counts[key] = count;
  }
  return counts;
}

const SNAPSHOT_STATUSES = ['current', 'source_changed', 'unknown'] as const;

function snapshotStatusOf(value: unknown): ChatAuditSummary['selection_snapshot_status'] | undefined {
  return typeof value === 'string' &&
    (SNAPSHOT_STATUSES as readonly string[]).includes(value)
    ? (value as NonNullable<ChatAuditSummary['selection_snapshot_status']>)
    : undefined;
}

/**
 * 越界引用编号归一：只收非负有限整数，去重后升序。
 *
 * 非数组返回 `null`（表示「这条数据没有编号」），空数组返回 `[]`（表示「确实没有越界引用」）：
 * 调用方据此区分「旧数据只有计数」与「新数据无越界」，前者不能凭空造编号。
 */
function citationIdsOf(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<number>();
  for (const item of value) {
    if (typeof item === 'number' && Number.isFinite(item) && Number.isInteger(item) && item >= 0) {
      ids.add(item);
    }
  }
  return [...ids].sort((left, right) => left - right);
}

type InvalidCitationFields = Pick<
  ChatAuditSummary,
  'invalid_citations' | 'invalid_citation_ids' | 'invalid_citations_truncated'
>;

/**
 * 新产生的越界引用编号 → 摘要字段：计数 + 截断后的编号数组（没有越界引用时只写 0 计数）。
 *
 * 编号与计数同源（同一数组），不会出现「编号与计数对不上」；超过上限只存前
 * `MAX_AUDIT_INVALID_CITATION_IDS` 个并置 `invalid_citations_truncated`，计数仍记全量。
 */
export function invalidCitationSummaryFields(ids: readonly number[]): InvalidCitationFields {
  const normalized = citationIdsOf(ids) ?? [];
  const fields: InvalidCitationFields = { invalid_citations: normalized.length };
  if (normalized.length === 0) return fields;
  fields.invalid_citation_ids = normalized.slice(0, MAX_AUDIT_INVALID_CITATION_IDS);
  if (normalized.length > MAX_AUDIT_INVALID_CITATION_IDS) {
    fields.invalid_citations_truncated = true;
  }
  return fields;
}

/**
 * 已落库摘要对象里的越界引用字段 → 摘要字段。
 *
 * 迁移前的老摘要只有计数：原样保留计数、不造编号；已有编号时保留编号与截断标记，
 * 重新压缩（响应里带旧 `audit_summary`）时不丢失。
 */
function invalidCitationFieldsOfSummary(existing: RecordLike | null): InvalidCitationFields {
  const ids = citationIdsOf(existing?.invalid_citation_ids);
  const count = Math.max(countOrZero(existing?.invalid_citations), ids?.length ?? 0);
  if (!ids || ids.length === 0) return { invalid_citations: count };
  const fields: InvalidCitationFields = {
    invalid_citations: count,
    invalid_citation_ids: ids.slice(0, MAX_AUDIT_INVALID_CITATION_IDS)
  };
  if (
    ids.length > MAX_AUDIT_INVALID_CITATION_IDS ||
    count > ids.length ||
    existing?.invalid_citations_truncated === true
  ) {
    fields.invalid_citations_truncated = true;
  }
  return fields;
}

/**
 * 把一轮 ChatResponse（或它的持久化形态）压成落库摘要。
 *
 * 计数优先取 `audit.claims`（最细、最权威）；没有逐段明细时退回响应里已有的
 * `audit_summary` 计数字段。越界引用优先取响应顶层的 `invalid_citations` 编号数组
 * （编号与计数同源）；只有旧摘要计数时保留计数、不造编号。
 * 完全没有任何审计信息时返回 null（不写空摘要）。
 *
 * 入参不限于完整 ChatResponse：调用点只带可见审计字段时（例如请求 body 里的
 * `audit` / `claims` / `invalid_citations` / `selection_snapshot`），按同一口径压缩。
 */
export function auditSummaryFromResponse(value: unknown): ChatAuditSummary | null {
  if (!isRecord(value)) return null;
  const audit = isRecord(value.audit) ? value.audit : null;
  // 没有完整响应时，调用点也可能只把论断明细放在顶层 `claims` 数组（请求体的可见字段）：
  // 与 `audit.claims` 同等对待；计数仍只看数组里的逐条记录。
  const claimRows =
    audit && Array.isArray(audit.claims)
      ? audit.claims
      : Array.isArray(value.claims)
        ? value.claims
        : [];
  const claims = claimRows.filter(isRecord);
  const existing = isRecord(value.audit_summary) ? value.audit_summary : null;
  const snapshot = isRecord(value.selection_snapshot) ? value.selection_snapshot : null;

  // 越界引用编号的来源：本轮响应顶层的 `invalid_citations`（阅读链路从回答正文解析出的
  // `[n]` 序号）最权威；没有时沿用响应里已有摘要的编号/计数（旧数据只有计数）。
  const invalidCitations = Array.isArray(value.invalid_citations)
    ? invalidCitationSummaryFields(value.invalid_citations)
    : invalidCitationFieldsOfSummary(existing);
  const selectionStatus =
    snapshotStatusOf(snapshot?.status) ?? snapshotStatusOf(existing?.selection_snapshot_status);

  if (
    claims.length === 0 &&
    !existing &&
    invalidCitations.invalid_citations === 0 &&
    !selectionStatus
  ) {
    return null;
  }

  const hasClaims = claims.length > 0;
  const verdicts = claims.map((claim) =>
    typeof claim.verdict === 'string' ? claim.verdict : ''
  );
  const sourceChanged = hasClaims
    ? claims.filter(
        (claim) => claim.verdict === 'unsupported' && claim.evidence_status === 'source_changed'
      ).length
    : countOrZero(existing?.source_changed);

  const summary: ChatAuditSummary = {
    claims: hasClaims ? claims.length : countOrZero(existing?.claims),
    supported: hasClaims
      ? verdicts.filter((verdict) => verdict === 'supported').length
      : countOrZero(existing?.supported),
    inference: hasClaims
      ? verdicts.filter((verdict) => verdict === 'inference').length
      : countOrZero(existing?.inference),
    unsupported: hasClaims
      ? verdicts.filter((verdict) => verdict === 'unsupported').length
      : countOrZero(existing?.unsupported),
    heading: hasClaims
      ? verdicts.filter((verdict) => verdict === 'heading').length
      : countOrZero(existing?.heading),
    claim_types: hasClaims
      ? claims.reduce<Record<string, number>>((counts, claim) => {
          if (typeof claim.claim_type === 'string' && claim.claim_type) {
            counts[claim.claim_type] = (counts[claim.claim_type] ?? 0) + 1;
          }
          return counts;
        }, {})
      : claimTypesOf(existing?.claim_types),
    source_changed: sourceChanged,
    ...invalidCitations
  };
  if (selectionStatus) summary.selection_snapshot_status = selectionStatus;
  return summary;
}

/**
 * 容错解析 `messages.audit_summary` 列。
 *
 * 坏 JSON、非对象、缺少核心计数字段 → 返回 null（当作这条消息没有摘要），不抛错。
 */
export function parseAuditSummary(raw: string | null | undefined): ChatAuditSummary | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const claims = countOf(parsed.claims);
  const supported = countOf(parsed.supported);
  const inference = countOf(parsed.inference);
  const unsupported = countOf(parsed.unsupported);
  const heading = countOf(parsed.heading);
  if (
    claims === null ||
    supported === null ||
    inference === null ||
    unsupported === null ||
    heading === null
  ) {
    return null;
  }
  const summary: ChatAuditSummary = {
    claims,
    supported,
    inference,
    unsupported,
    heading,
    claim_types: claimTypesOf(parsed.claim_types),
    source_changed: countOrZero(parsed.source_changed),
    // 编号数组容错：坏值丢弃、去重升序、按上限截断；老摘要没有编号时只恢复计数。
    ...invalidCitationFieldsOfSummary(parsed)
  };
  const selectionStatus = snapshotStatusOf(parsed.selection_snapshot_status);
  if (selectionStatus) summary.selection_snapshot_status = selectionStatus;
  return summary;
}

/** 摘要 → `messages.audit_summary` 列文本；没有摘要时写 NULL。 */
export function serializeAuditSummary(summary: ChatAuditSummary | null | undefined): string | null {
  return summary ? JSON.stringify(summary) : null;
}
