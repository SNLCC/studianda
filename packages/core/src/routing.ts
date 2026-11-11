/**
 * 来源路由的地基：一个 claim 需要多硬的证据、
 * 该去哪里找。**纯函数，不联网、不调模型。**
 *
 * 要防的失败方式：把「模型知道」当成「已经有了足够证据」。模型非常清楚「情感主义是什么意思」，
 * 但这不意味着一个要求可靠学术解释的问题不需要权威依据；反过来，「帮我把这句话说得通俗点」
 * 也不需要为每个词去查专业词条。因此判断不是「要不要联网」，而是：
 *
 *     claim 的性质（claim_type）× 需要多硬的证据（evidence_standard）
 *     × 当前文献答到什么程度（answerability）× 用户给没给权限（permission）
 *
 * 三条硬口径（都是本项目的既有原则，本模块只把它们写成函数）：
 * 1. **外部来源永远不能改写文献覆盖状态**。这里只产出「去哪儿找」的建议，文献覆盖由阅读侧负责；
 * 2. **权限是许可，不是命令**。用户允许「查找权威资料」不等于每一问都去查；
 * 3. **不是什么都要外部证据**。LIGHT（解释上下文、通俗化）用现有材料就够。
 */

/** claim 的性质。不同类型要求的来源完全不同（`CLAIM_TYPES`）。 */
export type ClaimType =
  | 'DOCUMENT_INTERPRETATION'
  | 'CONCEPT_DEFINITION'
  | 'SCHOLARLY_POSITION'
  | 'HISTORICAL_FACT'
  | 'BIBLIOGRAPHIC_FACT'
  | 'CONTESTED_INTERPRETATION'
  | 'CURRENT_INFORMATION'
  | 'BACKGROUND_EXPLANATION';

export const CLAIM_TYPES: readonly ClaimType[] = [
  'DOCUMENT_INTERPRETATION',
  'CONCEPT_DEFINITION',
  'SCHOLARLY_POSITION',
  'HISTORICAL_FACT',
  'BIBLIOGRAPHIC_FACT',
  'CONTESTED_INTERPRETATION',
  'CURRENT_INFORMATION',
  'BACKGROUND_EXPLANATION'
];

/** 证据等级：模型自己解释就够 / 必须有可核验依据 / 必须达到学术研究级依据。 */
export type EvidenceStandard = 'LIGHT' | 'GROUNDED' | 'SCHOLARLY';

export const EVIDENCE_STANDARDS: readonly EvidenceStandard[] = ['LIGHT', 'GROUNDED', 'SCHOLARLY'];

/**
 * 来源种类（`MODEL_BACKGROUND` 与 `SYSTEM_INFERENCE` 刻意排在最后：
 * 模型是理解器与综合器，不默认是学术证据库）。
 */
export type SourceKind =
  | 'CURRENT_DOCUMENT'
  | 'LIBRARY_DOCUMENT'
  | 'PRIMARY_EXTERNAL_SOURCE'
  | 'SCHOLARLY_REFERENCE'
  | 'OFFICIAL_SOURCE'
  | 'GENERAL_WEB'
  | 'MODEL_BACKGROUND'
  | 'SYSTEM_INFERENCE';

export const SOURCE_KINDS: readonly SourceKind[] = [
  'CURRENT_DOCUMENT',
  'LIBRARY_DOCUMENT',
  'PRIMARY_EXTERNAL_SOURCE',
  'SCHOLARLY_REFERENCE',
  'OFFICIAL_SOURCE',
  'GENERAL_WEB',
  'MODEL_BACKGROUND',
  'SYSTEM_INFERENCE'
];

/** 需要联网/外部检索的来源种类。 */
export const EXTERNAL_KINDS: readonly SourceKind[] = [
  'PRIMARY_EXTERNAL_SOURCE',
  'SCHOLARLY_REFERENCE',
  'OFFICIAL_SOURCE',
  'GENERAL_WEB'
];

const EXTERNAL_SET = new Set<SourceKind>(EXTERNAL_KINDS);

/** 先找什么、后找什么（固定顺序表）。 */
const PREFERENCE: Record<ClaimType, readonly SourceKind[]> = {
  DOCUMENT_INTERPRETATION: ['CURRENT_DOCUMENT', 'LIBRARY_DOCUMENT', 'SCHOLARLY_REFERENCE'],
  CONCEPT_DEFINITION: ['CURRENT_DOCUMENT', 'SCHOLARLY_REFERENCE', 'PRIMARY_EXTERNAL_SOURCE', 'GENERAL_WEB'],
  SCHOLARLY_POSITION: ['PRIMARY_EXTERNAL_SOURCE', 'SCHOLARLY_REFERENCE', 'CURRENT_DOCUMENT'],
  HISTORICAL_FACT: ['PRIMARY_EXTERNAL_SOURCE', 'SCHOLARLY_REFERENCE', 'OFFICIAL_SOURCE'],
  BIBLIOGRAPHIC_FACT: ['OFFICIAL_SOURCE', 'SCHOLARLY_REFERENCE', 'LIBRARY_DOCUMENT'],
  CONTESTED_INTERPRETATION: ['SCHOLARLY_REFERENCE', 'PRIMARY_EXTERNAL_SOURCE', 'LIBRARY_DOCUMENT'],
  CURRENT_INFORMATION: ['OFFICIAL_SOURCE', 'GENERAL_WEB'],
  BACKGROUND_EXPLANATION: ['CURRENT_DOCUMENT', 'MODEL_BACKGROUND']
};

/**
 * 当前文献「答到什么程度」是否已足以支撑这个 claim。SUFFICIENT 只对**文献解释类**问题成立：
 * 「作者在本文怎么理解 X」当然由原文说了算；「X 学界一般怎么界定」不能只靠这一篇。
 */
const DOCUMENT_ENOUGH = new Set<ClaimType>(['DOCUMENT_INTERPRETATION', 'BACKGROUND_EXPLANATION']);

/**
 * 每条 claim 至少需要多硬的证据（**不是**模型说了算的那一档）。
 *
 * 为什么要有下限：`standard` 一旦由模型自己填，最省事的回答方式就是把所有论断都写成 LIGHT，
 * 于是「不需要外部依据」变成模型的自我豁免。下限让模型**只能往上提、不能往下压**。
 * 下限本身刻意保守（不是「凡论文必学术级」）：
 * - 论文解释、背景解释要的是**可核验依据**：能指回原文，不靠印象；
 * - 定义、学派立场、史实、文献事实、争议解读都要**学术研究级**依据；
 * - 时效性信息要**官方来源**级依据。
 */
const MINIMUM_STANDARD: Record<ClaimType, EvidenceStandard> = {
  DOCUMENT_INTERPRETATION: 'GROUNDED',
  BACKGROUND_EXPLANATION: 'GROUNDED',
  CONCEPT_DEFINITION: 'SCHOLARLY',
  SCHOLARLY_POSITION: 'SCHOLARLY',
  HISTORICAL_FACT: 'SCHOLARLY',
  BIBLIOGRAPHIC_FACT: 'SCHOLARLY',
  CONTESTED_INTERPRETATION: 'SCHOLARLY',
  CURRENT_INFORMATION: 'SCHOLARLY'
};

const LEVEL_ORDER: Record<EvidenceStandard, number> = { LIGHT: 0, GROUNDED: 1, SCHOLARLY: 2 };

function isClaimType(value: unknown): value is ClaimType {
  return typeof value === 'string' && (CLAIM_TYPES as readonly string[]).includes(value);
}

function isEvidenceStandard(value: unknown): value is EvidenceStandard {
  return typeof value === 'string' && (EVIDENCE_STANDARDS as readonly string[]).includes(value);
}

/**
 * 把模型给的 claim 性质归一化（`claim_type`）：
 * 词表外的值一律退回最保守的那一档，不抛错、也不当成「随便找」。
 */
export function claimType(value: unknown): ClaimType {
  return isClaimType(value) ? value : 'BACKGROUND_EXPLANATION';
}

/**
 * 这条 claim 的最低证据等级（`MINIMUM_STANDARD`）。
 *
 * 注意口径：先按 `claim_type` 归一化再查表，因此**词表外的类型实际取
 * BACKGROUND_EXPLANATION 的 GROUNDED**（表里的兜底值 'SCHOLARLY' 永远命中不到）；
 * 这里不自行改成更严的 SCHOLARLY。
 */
export function minimumStandard(claim: unknown): EvidenceStandard {
  return MINIMUM_STANDARD[claimType(claim)] ?? 'SCHOLARLY';
}

/**
 * 定下这条 claim 实际按多严的标准找证据：**模型只能往上提，不能往下压**。
 *
 * - 模型给了合法的、比下限更严的等级 → 采纳它；
 * - 模型给得比下限低、给了词表外的值、或根本没给 → 一律取下限；
 * - 唯一例外是被标成**未经核验的背景知识**（`verdict='background'`，只在用户明确允许模型
 *   背景知识时出现）：那一段已如实标着「未核验」，只需解释、不需要依据，因此可走 LIGHT。
 *   除此之外 LIGHT 不是模型可以给自己发的豁免。
 */
export function resolveStandard(
  claim: unknown,
  declared: unknown,
  verdict = ''
): EvidenceStandard {
  const given = isEvidenceStandard(declared) ? declared : '';
  const floor = minimumStandard(claim);
  if (given && LEVEL_ORDER[given] >= LEVEL_ORDER[floor]) return given;
  if (verdict === 'background' && LEVEL_ORDER[floor] > LEVEL_ORDER.LIGHT) return 'LIGHT';
  return floor;
}

/**
 * 这条 claim 找证据的顺序（`source_order`）。
 *
 * `sourcePlan` 内部按「文献内 / 外部」拆开它，接线层想知道「没获授权时会缺哪一类」时也用它——
 * 两处共用同一张表，避免「建议用 A、实际去找 B」。
 */
export function sourceOrder(claimTypeValue: unknown): readonly SourceKind[] {
  return PREFERENCE[claimType(claimTypeValue)];
}

export interface SourcePlan {
  claim_type: ClaimType;
  standard: EvidenceStandard;
  /** 实际建议使用的来源（文献内来源 + 已获授权的外部来源）。 */
  sources: SourceKind[];
  needs_external: boolean;
  /** 按性质想找、但本轮没有授权的外部来源（报告要如实说出来，不能假装查过）。 */
  blocked_external: SourceKind[];
  reason: string;
}

type ReasonAnswerability =
  | 'SUFFICIENT'
  | 'PARTIAL'
  | 'MENTION_ONLY'
  | 'ABSENT'
  | 'CONFLICTING'
  | string
  | null
  | undefined;

/** 给报告用的一句话原因（文案固定）。 */
function reasonFor(
  claim: ClaimType,
  level: EvidenceStandard,
  answerability: ReasonAnswerability,
  wanted: readonly SourceKind[],
  external: readonly SourceKind[]
): string {
  if (level === 'LIGHT') return '只需解释现有材料，不需要外部依据';
  if (wanted.length === 0) {
    if (answerability === 'SUFFICIENT' && DOCUMENT_ENOUGH.has(claim)) {
      return '当前文献已给出界定或解释，外部资料不必要（有也不改变"文献说了什么"）';
    }
    return '按该 claim 的性质，优先使用当前文献与文献库';
  }
  if (external.length === 0) {
    return '需要外部资料，但本轮没有获得相应授权；不改动文献覆盖状态，只按现有材料作答';
  }
  if (
    answerability === 'MENTION_ONLY' ||
    answerability === 'PARTIAL' ||
    answerability === 'ABSENT' ||
    !answerability
  ) {
    return `当前文献对这个问题是 ${answerability || '未知'}，按 claim 性质需要外部依据`;
  }
  return '按 claim 性质需要外部依据';
}

/**
 * 给出一条 claim 的来源计划（`sourcePlan`）：先看哪里、需不需要外部、以及**为什么**。
 *
 * - `allowed` 是用户给的外部来源权限（`EXTERNAL_KINDS` 的子集）；没给权限时**只**产出文献内建议，
 *   并把原因写清楚（「需要外部资料但本轮没有授权」），而不是悄悄去找；
 * - LIGHT 等级不要求外部：现有材料与模型解释足够；
 * - `answerability='SUFFICIENT'` 且属于文献解释类问题时，外部来源**不必要**（有权威资料也不改口径）。
 */
export function sourcePlan(
  claimTypeValue: unknown,
  standard: unknown = 'GROUNDED',
  answerability: ReasonAnswerability = null,
  allowed: readonly SourceKind[] = []
): SourcePlan {
  const claim = claimType(claimTypeValue);
  const level = isEvidenceStandard(standard) ? standard : 'GROUNDED';
  const order = PREFERENCE[claim];
  const permitted = new Set<SourceKind>(allowed);
  const sources = order.filter((kind) => !EXTERNAL_SET.has(kind));
  let wanted: SourceKind[] = [];
  if (level !== 'LIGHT') {
    // 文献已足够回答（且这是文献解释类问题）时不需要外部；其余情况按偏好表找外部。
    const enough = answerability === 'SUFFICIENT' && DOCUMENT_ENOUGH.has(claim);
    if (!enough) wanted = order.filter((kind) => EXTERNAL_SET.has(kind));
  }
  const external = wanted.filter((kind) => permitted.has(kind));
  if (external.length > 0) sources.push(...external);
  return {
    claim_type: claim,
    standard: level,
    sources,
    needs_external: external.length > 0,
    blocked_external: wanted.filter((kind) => !permitted.has(kind)),
    reason: reasonFor(claim, level, answerability, wanted, external)
  };
}

/** 这次「想找但没权限」的来源种类：报告里要如实说出来。 */
export function externalBlocked(plan: { blocked_external?: SourceKind[] } | null | undefined): SourceKind[] {
  return [...(plan?.blocked_external ?? [])];
}
