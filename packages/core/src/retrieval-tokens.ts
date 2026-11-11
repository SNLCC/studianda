/**
 * 检索分词：英文/数字词 + 中文双字。
 *
 * 单独成模块，避免「检索排名」与「内存倒排索引」互相 import 形成循环。
 */

export function tokens(text: string): string[] {
  const lower = text.toLowerCase();
  const withoutCjk = lower.replace(/[\u4e00-\u9fff]+/g, ' ');
  const english = withoutCjk.match(/[\p{L}\p{N}]+/gu) ?? [];
  const chinese: string[] = [];
  for (const match of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = [...match[0]];
    if (run.length === 1) {
      chinese.push(run[0] as string);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      chinese.push(`${run[index]}${run[index + 1]}`);
    }
  }
  return [...english, ...chinese];
}

export function countTokens(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}
