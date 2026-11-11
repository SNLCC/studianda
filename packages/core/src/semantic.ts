/**
 * 语义宽召回：**再找一遍“可能相关”的位置**，不是“最相关的那几个”。
 *
 * 三条口径：
 * 1. 只增不减：语义召回只补页，不去掉任何原范围/词面命中；
 * 2. 不猜：绝对阈值 + 相对最优两条同时满足才算候选，不取固定 Top-K；
 * 3. 失败即降级：调用方把失败收敛成“这一路没跑”，不让整次提问失败。
 */

export const MIN_SIMILARITY = 0.3;
export const RELATIVE_CUTOFF = 0.8;
export const DEFAULT_LIMIT = 8;

/** 余弦相似度；零向量/维度不一致返回 0，不抛错。 */
export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left || !right || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/**
 * 从 `页码 → 相似度` 里挑候选：绝对过线且不低于最佳候选的 cutoff 倍，页码升序。
 * 一个都不满足时返回空——不靠降低标准凑出几页。
 */
export function pickPages(
  scores: Record<number, number> | Map<number, number>,
  limit = DEFAULT_LIMIT,
  minimum = MIN_SIMILARITY,
  cutoff = RELATIVE_CUTOFF
): number[] {
  const entries: Array<[number, number]> =
    scores instanceof Map ? [...scores.entries()] : Object.entries(scores).map(([key, value]) => [Number(key), value]);
  const rows = entries.filter(
    ([page, score]) =>
      Number.isInteger(page) && page >= 1 && Number.isFinite(score) && score >= minimum
  );
  if (rows.length === 0) return [];
  const best = Math.max(...rows.map(([, score]) => score));
  const floor = Math.max(minimum, best * cutoff);
  const chosen = rows
    .filter(([, score]) => score >= floor)
    .map(([page]) => page)
    .sort((left, right) => left - right);
  return limit > 0 ? chosen.slice(0, limit) : chosen;
}

/**
 * 把“每段一个向量”折成候选页：同一页取最高相似度，再走 `pickPages`。
 * 向量数量与文字数量不一致时按较短的一边处理，不抛错。
 */
export function hitPagesFor(
  rows: Array<[number, string]>,
  queryVector: number[],
  vectors: number[][],
  limit = DEFAULT_LIMIT,
  minimum = MIN_SIMILARITY,
  cutoff = RELATIVE_CUTOFF
): number[] {
  const best = new Map<number, number>();
  for (let index = 0; index < rows.length; index += 1) {
    if (index >= vectors.length) break;
    const [page] = rows[index]!;
    if (!Number.isInteger(page) || page < 1) continue;
    const score = cosineSimilarity(queryVector, vectors[index]!);
    if (score > (best.get(page) ?? Number.NEGATIVE_INFINITY)) best.set(page, score);
  }
  return pickPages(best, limit, minimum, cutoff);
}
