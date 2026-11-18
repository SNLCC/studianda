/**
 * 证据审计的展示口径：缺证 / 原文已变更的计数与文案，以及「本轮记录」折叠摘要。
 *
 * 为什么单独放一个模块：`source_changed`（提问时冻结的选区文字在当前页已找不到）造成的缺证
 * **不是模型编造**，必须在计数与文案上与普通缺证分开。这条口径以前内联在 ChatPanel 里，
 * 只能靠临时 SSR 冒烟覆盖；提取成纯函数后由 `test/chat-audit.test.ts` 回归，
 * ChatPanel 只负责把状态接上，不再复写判定与文案。
 */
import type { ChatResponse } from '@studianda/shared';

/** 回答方式（与 ChatResponse.answer_mode 一一对应，独立会话页也会用到）。 */
export const ANSWER_MODE_LABELS: Record<string, string> = {
  library: '库内检索会话',
  reading: '文献精读',
  web: '联网结果',
  direct: '直接回复'
};

/**
 * 本轮 token 用量：有输入/输出就分别列，否则列总数；供应商没返回 usage 时明确标“估算”。
 * 有缓存命中时挂在输入后面（它是输入的一部分，不单列成一项，避免看起来像额外开销）；
 * 思考 token 同理挂在输出后面（它已包含在输出里），让"思考花了多少"可见。
 */
export function formatUsage(usage: NonNullable<ChatResponse['usage']>): string | null {
  const count = (value?: number): string =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.round(value)).toLocaleString('zh-CN')
      : '';
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const total = count(usage.total_tokens);
  const cached = count(usage.cached_tokens);
  const reasoning = count(usage.reasoning_tokens);
  const parts: string[] = [];
  if (input) parts.push(cached ? `输入 ${input}（缓存命中 ${cached}）` : `输入 ${input}`);
  if (output) parts.push(reasoning ? `输出 ${output}（其中思考 ${reasoning}）` : `输出 ${output}`);
  const body = parts.length > 0 ? parts.join(' · ') : total ? `合计 ${total}` : '';
  if (!body) return null;
  return (
    `本轮 tokens：${body}` +
    (usage.calls && usage.calls > 1 ? `（${usage.calls} 次模型调用）` : '') +
    (usage.estimated ? '（估算）' : '')
  );
}

/** 折叠摘要里的紧凑用量：只保留输入/输出，避免把 tokens 明细整行顶在回答下面。 */
export function formatUsageCompact(usage: NonNullable<ChatResponse['usage']>): string {
  const count = (value?: number): string =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.round(value)).toLocaleString('zh-CN')
      : '';
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  if (input && output) return `输入 ${input} / 输出 ${output}`;
  const total = count(usage.total_tokens);
  return total ? `共 ${total} tokens` : '';
}

/** shared 的 `audit.claims` 是内联结构：这里取同一份字段类型，避免手写重复定义。 */
export type AuditClaim = NonNullable<ChatResponse['audit']>['claims'][number];

/**
 * 缺证归因：`source_changed` = 提问时冻结的选区文字在当前页已找不到（OCR 重跑/页校订
 * 改写所致），这类“缺证”只是原文变了，**不是模型编造**。
 */
export function isSourceChangedClaim(claim: AuditClaim): boolean {
  return claim.verdict === 'unsupported' && claim.evidence_status === 'source_changed';
}

/** 把核验不过的论断按归因拆开：普通缺证 / 原文已变更（两者要分别计数展示）。 */
export function splitUnsupportedClaims(response: ChatResponse | undefined): {
  plain: AuditClaim[];
  sourceChanged: AuditClaim[];
} {
  const unsupported = (response?.audit?.claims ?? []).filter(
    (claim) => claim.verdict === 'unsupported'
  );
  return {
    plain: unsupported.filter((claim) => !isSourceChangedClaim(claim)),
    sourceChanged: unsupported.filter(isSourceChangedClaim)
  };
}

/**
 * 缺证计数（展示口径）：优先用 `audit.claims` 逐段明细；历史消息只有落库摘要
 * （`audit_summary`，没有逐段明细）时退回摘要计数，保证「缺证 N 段 · 原文已变更 N 段」
 * 在重开历史后仍能恢复。`source_changed` 包含在 `unsupported` 里，先扣掉再单列。
 */
export function unsupportedCounts(response: ChatResponse | undefined): {
  plain: number;
  sourceChanged: number;
} {
  const summary = response?.audit_summary;
  const claims = response?.audit?.claims ?? [];
  const sourceChanged = splitUnsupportedClaims(response).sourceChanged.length;
  const sourceChangedCount =
    typeof summary?.source_changed === 'number' ? summary.source_changed : sourceChanged;
  const unsupportedCount =
    claims.length > 0
      ? claims.filter((claim) => claim.verdict === 'unsupported').length
      : (summary?.unsupported ?? 0);
  return {
    plain: Math.max(0, unsupportedCount - sourceChangedCount),
    sourceChanged: sourceChangedCount
  };
}

/** 审计摘要的计数行（活跃响应与「只有摘要」的历史消息共用同一套文案）。 */
export function auditSummaryLine(response: ChatResponse | undefined): string {
  const summary = response?.audit_summary;
  if (!summary) return '';
  const { plain, sourceChanged } = unsupportedCounts(response);
  return (
    `支持 ${summary.supported} · 推断 ${summary.inference} · 缺证 ${plain}` +
    (sourceChanged > 0 ? ` · 原文已变更 ${sourceChanged}` : '') +
    ` · 标题 ${summary.heading}`
  );
}

/**
 * 选区快照的「原文已变更」提示：只有当前页确实找不到提问时的选区时才需要提示，
 * 状态为 current/unknown 时不额外占一行。
 */
export function changedSelectionSnapshot(
  response: ChatResponse | undefined
): NonNullable<ChatResponse['selection_snapshot']> | null {
  const snapshot = response?.selection_snapshot;
  if (!snapshot) return null;
  if (snapshot.status === 'source_changed') return snapshot;
  if ((snapshot.source_changed_claims ?? []).length > 0) return snapshot;
  return null;
}

/**
 * 「本轮记录」折叠时的摘要：回答方式、tokens、依据/引用/审计条数。
 *
 * 回答下方的诊断项很多（回答方式、用量、可答性、路由、覆盖、审计……），全部展开时
 * 会把回答挤出屏幕。默认折叠，摘要里保留最常用的事实，展开后才是逐项明细。
 */
export function turnRecordSummary(response: ChatResponse | undefined): string {
  if (!response) return '';
  const parts: string[] = [];
  if (response.answer_mode) {
    parts.push(ANSWER_MODE_LABELS[response.answer_mode] ?? response.answer_mode);
  }
  if (response.usage) {
    const usage = formatUsageCompact(response.usage);
    if (usage) parts.push(usage);
  }
  if (response.sources && response.sources.length > 0) {
    parts.push(`依据 ${response.sources.length} 条`);
  }
  if (response.citation_support && response.citation_support.citations > 0) {
    parts.push(`引用 ${response.citation_support.citations} 条`);
  }
  // 缺证按归因分开计数：原文已变更造成的缺证不能混进「缺证」当成模型编造。
  const claims = response.audit?.claims ?? [];
  const { plain: plainCount, sourceChanged: sourceChangedCount } = unsupportedCounts(response);
  if (plainCount > 0 && sourceChangedCount > 0) {
    parts.push(`缺证 ${plainCount} 段 · 原文已变更 ${sourceChangedCount} 段`);
  } else if (sourceChangedCount > 0) {
    parts.push(`原文已变更 ${sourceChangedCount} 段`);
  } else if (plainCount > 0) {
    parts.push(`缺证 ${plainCount} 段`);
  } else if (claims.length > 0 || response.audit_summary) {
    parts.push(`审计 ${response.audit_summary?.claims ?? claims.length} 段`);
  }
  if (response.audit?.status === '部分段落未完成复核') parts.push('审计部分未完成');
  else if (response.audit && response.audit.status !== '已进行模型证据支持复核') {
    parts.push('审计未完成');
  }
  return parts.join(' · ');
}

/** 审计异常或普通缺证时让折叠摘要变红，避免默认收起把风险提示一起藏掉。 */
export function turnRecordHasAlert(response: ChatResponse | undefined): boolean {
  if (!response) return false;
  // 「原文已变更」的缺证不是模型编造，不按错误级别标红；只有普通缺证/审计异常才标红。
  return Boolean(
    unsupportedCounts(response).plain > 0 ||
      (response.audit && response.audit.status !== '已进行模型证据支持复核')
  );
}

/** 是否有需要收进「本轮记录」的诊断字段（没有就不渲染空折叠项）。 */
export function hasTurnRecord(response: ChatResponse | undefined): boolean {
  if (!response) return false;
  return Boolean(
    response.answer_mode ||
      response.usage ||
      response.route_note ||
      response.answerability ||
      response.evidence_accounting ||
      response.source_routing ||
      response.routing ||
      response.chapter ||
      response.plan ||
      response.sources?.length ||
      response.memory_sources?.length ||
      response.memory_notice ||
      response.coverage ||
      response.coverage_ledger?.length ||
      response.gap_search ||
      response.citation_support ||
      response.audit ||
      response.audit_summary ||
      response.falsify ||
      response.unread_pages?.length
  );
}
