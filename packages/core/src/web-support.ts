/**
 * 联网补查的可见记账与说明。
 *
 * 这一层只做**纯函数**：不发请求、不读设置。真正发出搜索仍由 chat.ts 调 `searchWeb`
 * （唯一出口），本模块只决定「该查什么、查完怎么记账、为什么没查」。
 *
 * 两条纪律：
 * 1. 权限是许可不是命令：只有审计 routing 认为「按性质需要外部依据」的论断才算缺口；
 * 2. 不编造"已查"：没有真正发出请求时状态必须写「未发起：原因」，结果为空也要如实说。
 */
import type { AuditReport, ClaimRoute } from './audit.js';

export interface AutoSourceQueriesResult {
  /** 要放进搜索的关键词（最多 `limit` 条，去重后）；没有缺口时为空。 */
  queries: string[];
  /** 这些关键词对应的论断编号（带 claim_type/needs 的对象；这里记账只用编号）。 */
  claims: number[];
  /** 为什么查 / 为什么不查（原文语义）。 */
  reason: string;
  /** 这一问本身要求外部资料（路由 search=true），但链路没有外部论断时的提议查询。 */
  requested?: boolean;
}

/** 论断性质 → 中文查询词后缀。 */
const CLAIM_KIND_LABELS: Record<string, string> = {
  CONCEPT_DEFINITION: '概念界定',
  SCHOLARLY_POSITION: '学术立场',
  HISTORICAL_FACT: '史实',
  BIBLIOGRAPHIC_FACT: '文献事实',
  CONTESTED_INTERPRETATION: '有争议的解读',
  CURRENT_INFORMATION: '时效性信息',
  DOCUMENT_INTERPRETATION: '作者的解读',
  BACKGROUND_EXPLANATION: '背景解释'
};

/**
 * 由**链路自己**发起的定向查证该查什么。
 *
 * 口径：
 * - 只有「需要外部依据、但文献没提供」的论断才算缺口；没有缺口返回空 queries；
 * - 查询词来自已有记录（论断性质 + 首个问题术语/原问题），不额外调模型；
 * - `searchRequested`：问题本身要最新外部事实（路由 search=true）时，即使没有外部论断
 *   也提议一个关键词（仍要过用户 permission 档位）。
 *
 * 缺口判断的一处约定：`audit.routeClaims` 在 permission=auto 时把四类外部来源都当成已授权，
 * `blocked_external` 会为空，但这一轮实际并没有联网。因此这里额外接受 `needs_external`——
 * 语义仍是「需要外部、本轮没用上」，不会把「文献已足够」的论断算成缺口。
 */
export function autoSourceQueries(
  routes: ClaimRoute[] | undefined,
  terms: string[],
  original: string,
  options: { limit?: number; searchRequested?: boolean } = {}
): AutoSourceQueriesResult {
  const limit = Math.max(0, options.limit ?? 3);
  const plans = (routes ?? []).filter(
    (route) =>
      Number.isInteger(route.claim) &&
      route.claim > 0 &&
      ((route.blocked_external?.length ?? 0) > 0 || route.needs_external === true)
  );
  const firstTerm =
    (terms ?? []).find((term) => typeof term === 'string' && term.trim().length >= 2)?.trim() ?? '';
  const fallback = typeof original === 'string' ? original.trim() : '';
  const base = (firstTerm.length >= 2 ? firstTerm : fallback).slice(0, 60);
  if (plans.length === 0) {
    if (options.searchRequested !== true) {
      return { queries: [], claims: [], reason: '本轮没有需要外部依据的论断' };
    }
    if (!base) {
      return { queries: [], claims: [], reason: '问题里没有可用于搜索的术语，未发起' };
    }
    return {
      queries: [base],
      claims: [],
      reason: '这一问需要外部资料（判断模型给出的结论）',
      requested: true
    };
  }
  const queries: string[] = [];
  const claims: number[] = [];
  for (const plan of plans) {
    const kind = CLAIM_KIND_LABELS[plan.claim_type] ?? '该论断';
    claims.push(plan.claim);
    if (!base) continue;
    const query = `${base} 的${kind}依据`;
    if (!queries.includes(query)) queries.push(query);
  }
  return {
    queries: queries.slice(0, limit),
    claims,
    reason: `本轮有 ${plans.length} 处论断按性质需要外部依据，文献里没有提供`
  };
}

/**
 * 「模型知识补充 · 未联网核验」前面那**一句人话**。
 *
 * 只把**已经记下来**的事实写成说明；没有记录就如实说没记录，不编原因。
 * 放进小节内容时需要两个换行，这里返回纯句子（调用方并入 notice）。
 */
export function whyNotOnline(
  sourcePolicy: string | undefined,
  auto: { status?: string } | undefined
): string {
  const status = String(auto?.status ?? '');
  if (sourcePolicy === 'document_only') {
    return '说明：设置里「智能来源」选的是「仅文献」，本轮不发送任何外部请求，因此没有联网核验。';
  }
  if (status.startsWith('已按论断缺口查证') || status.startsWith('已查证')) {
    return `说明：本轮已按论断缺口查证（${status}）；这一节仍是模型自身的知识，不是网页结论。`;
  }
  if (status.startsWith('未发起：')) {
    const detail = status.split('：').slice(1).join('：');
    return `说明：本轮没有发起联网查证——${detail}`;
  }
  if (status.includes('用户已关闭联网搜索')) {
    return '说明：联网搜索在设置里是关闭的，本轮没有发出任何请求，因此没有联网核验。';
  }
  if (status.includes('用户未同意新增搜索')) {
    return '说明：链路判断这一处需要外部依据并要求查证，但没有获得同意，因此保留文献结论、没有联网。';
  }
  if (status.includes('没有需要外部依据的论断')) {
    return (
      '说明：本轮没有发出联网查证，因为核对后的论断里没有一条按性质需要外部依据' +
      '（文献自身已能回答）。这一节只是模型自己的补充知识。'
    );
  }
  if (status.includes('查证未完成')) {
    return `说明：本轮尝试过联网查证，但没有完成（${status.split('：').slice(1).join('：')}）。`;
  }
  return '说明：本轮没有联网核验；应用没有记下"为什么没查"，因此这里不猜原因。';
}

/**
 * 合并两轮联网补查的审计结果：
 * 论断编号按 `offset` 平移到最终可见回答的行号，`段落 N：` 前缀的核对问题同步平移，
 * status 合成（两轮都完成才算完成），证据范围与复用/分组计数合并。
 *
 * **调用点说明（如实）**：TS 当前只有一轮联网补查、没有 followup 轮，因此这个函数
 * 目前只作为工具 + 单测存在，生产链路尚未调用；等 followup 轮接入后再在合并处使用，
 * 不要为了"看起来用了"而伪造调用。
 */
export function mergeWebReviews(
  previous: AuditReport,
  current: AuditReport,
  offset: number
): AuditReport {
  const shifted = <T extends { claim: number }>(rows: T[] | undefined): T[] =>
    (rows ?? []).map((row) => ({ ...row, claim: row.claim + offset }));
  const bothComplete =
    previous.status === '已进行模型证据支持复核' &&
    current.status === '已进行模型证据支持复核';
  const shiftIssue = (issue: string): string =>
    issue.replace(/^段落 (\d+)：/, (_match, number: string) => `段落 ${Number(number) + offset}：`);
  const previousRouting = previous.routing ?? [];
  const currentRouting = shifted(current.routing);
  const historyDropped = Math.max(previous.history_dropped ?? 0, current.history_dropped ?? 0);
  const previousRemoved = previous.page_mentions_removed ?? [];
  const currentRemoved = shifted(current.page_mentions_removed);
  return {
    ...current,
    status: bothComplete ? '已进行模型证据支持复核' : '部分段落未完成复核',
    issues: [...(previous.issues ?? []), ...(current.issues ?? []).map(shiftIssue)],
    claims: [...(previous.claims ?? []), ...shifted(current.claims)],
    ...(previousRemoved.length > 0 || currentRemoved.length > 0
      ? { page_mentions_removed: [...previousRemoved, ...currentRemoved] }
      : {}),
    reused_claims: (previous.reused_claims ?? 0) + (current.reused_claims ?? 0),
    audit_groups: (previous.audit_groups ?? 0) + (current.audit_groups ?? 0),
    evidence_scope: {
      mode: '按论断选取原文片段，非全书穷尽核查',
      groups: [...(previous.evidence_scope?.groups ?? []), ...(current.evidence_scope?.groups ?? [])]
    },
    ...(previousRouting.length > 0 || currentRouting.length > 0
      ? { routing: [...previousRouting, ...currentRouting] }
      : {}),
    // TS 独有的历史丢弃计数：合并时取两轮最大值（同一份历史不重复计数），不丢失记录。
    ...(historyDropped > 0 ? { history_dropped: historyDropped } : {})
  };
}
