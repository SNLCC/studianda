/**
 * 审计之后「要不要再回读原文」的门槛。
 *
 * 要防的失败方式：首答很快，但核对后不管什么问题都再回读一遍、整篇重写一遍、再核对一遍——
 * 用户为此多等两次完整生成，而结论一个字都没变。核对提出的问题其实分两类：
 *
 * - **覆盖类**（材料不够）：它说某条证据在**没读到的页/来源**里，或大量段落缺证——
 *   这时回读真有东西可补；
 * - **匹配类**（材料就在眼前）：摘引与论断不匹配、把标题当论断、摘引无法逐字核验……
 *   这些**再读一遍原文也不会变**：核对已经把那一段按「缺证」处理掉了，
 *   重写整篇只是把同样的材料再讲一遍。
 *
 * 因此只有覆盖类（或缺口数量够多）才触发回读与重写。这条判断**不改变任何核验口径**：
 * 逐字核验、证据银行、覆盖台账照旧；它只决定「要不要再花一次生成把同一份材料重讲一遍」。
 */

/**
 * 「证据在没读到的地方」的措辞。刻意保守：只认**明确说了没读到**的说法；
 * 提到页码或编号**不算**（「摘引其实逐字出现在 [3]」属于匹配类，那一页本来就读过），
 * 认不出来就当成匹配类（不回读）。
 */
const COVERAGE_HINTS = [
  '未读',
  '没有读到',
  '不在本轮',
  '未纳入',
  '未覆盖',
  'unread',
  'not read'
] as const;

/** 「缺证段落」在 issues 里的固定说法。 */
const MISSING_EVIDENCE_MARKER = '缺少本轮证据支持';

/** 这条核对问题是不是「证据在**没读到**的地方」（覆盖类）？ */
export function issueSuggestsCoverageGap(issue: string): boolean {
  if (typeof issue !== 'string' || !issue) return false;
  return COVERAGE_HINTS.some((hint) => issue.includes(hint));
}

/**
 * 核对提出的这些问题，**再读一遍原文能解决吗**？
 *
 * @param issues 审计报告里的 issues（非字符串项忽略）
 * @param minimumMissing 多少段「缺少本轮证据支持」才算材料确实不够（默认 2）
 */
export function worthRereading(issues: readonly unknown[], minimumMissing = 2): boolean {
  const rows = (issues ?? []).filter((issue): issue is string => typeof issue === 'string');
  if (rows.some((issue) => issueSuggestsCoverageGap(issue))) return true;
  const missing = rows.filter((issue) => issue.includes(MISSING_EVIDENCE_MARKER)).length;
  return missing >= minimumMissing;
}

/**
 * 不需要回读时给用户的如实说明。
 * 关键在于「没有重写」要说出来——否则用户会以为后面那一大段被省掉了。
 */
export const REREAD_SKIPPED_NOTE =
  '核对提出的问题不需要再读原文才能解决（多为摘引与论断不匹配，已按缺证处理）；本轮没有重写整篇回答。';
