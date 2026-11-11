import { createHash } from 'node:crypto';
import type { ReadingSource } from './reading.js';

/**
 * 内容寻址的批次存档键。
 *
 * 为什么不用「第几批」当键：批号只在同一次阅读里稳定。用户校订了一页、文献版本变了、
 * 容量变了导致重新分批，都会让**已经读过的批次错位**，「继续阅读」于是把读过的原文又读一遍
 * ——用户看到的就是「进度说保存了，却还在重来」。
 *
 * 键取这一批自己的来源与原文摘要，因此分批方式怎么变都不影响已完成的批次；
 * `identity` 只用于把「这一轮读的是什么」（问题、模型、容量等）一并钉进键里。
 *
 * **只放摘要、不放原文**：调用方（检查点存储）承诺不保存文献内容，
 * 因此存档键必须是不可逆的摘要，而不是把原文塞进键名里。
 */

export interface CheckpointKey {
  /** 按内容寻址的存档键（`batch:` / `reduce:` + 摘要前 32 位）。 */
  stage: string;
  /** 同一份摘要的完整形式，用于判断「存档里那条是不是这一批」。 */
  digest: string;
}

/**
 * 一条来源的稳定标识。来源 `id` 形如 `doc:pN:sha16`；这里没有该字段，
 * 用「文献 + 页」等价定位：同一篇文献同一页在一次阅读里就是一个来源。
 */
function sourceKeyOf(source: ReadingSource): string {
  return `${source.document_id}:${source.page}`;
}

function digestOf(identity: string, text: string): string {
  return createHash('sha256').update(`${identity}\u001e${text}`, 'utf8').digest('hex');
}

/**
 * 一批的存档键。
 *
 * `group` 是按来源编号排列的 `[编号, 来源]`；编号用于在 `sources` 里取来源标识，
 * 原文取 `row.text`。`group` 的顺序本身就是键的一部分：
 * 同一批换个顺序就是另一批，不能误复用。
 */
export function batchFingerprint(
  group: Array<[number, ReadingSource]>,
  sources: ReadingSource[],
  identity = ''
): CheckpointKey {
  const text = group
    .map(([index, row]) => {
      const source = sources[index - 1] ?? row;
      return `${sourceKeyOf(source)}\u001f${row.text}`;
    })
    .join('\n');
  const digest = digestOf(identity, text);
  return { stage: `batch:${digest.slice(0, 32)}`, digest };
}

/**
 * 压缩层（READING_REDUCE）一包的存档键。
 *
 * `pack` 是这一包派生阅读记录（不含原文）；对 `JSON.stringify` 的结果取 sha256
 * （全链路同一口径、确定性），前 32 位做 stage。
 * 这里与 `batch:` 保持同一形态——32 位十六进制在同一轮阅读内的碰撞概率可忽略，
 * 且键更短。
 */
export function reduceFingerprint(pack: unknown, identity = ''): CheckpointKey {
  const digest = digestOf(identity, JSON.stringify(pack));
  return { stage: `reduce:${digest.slice(0, 32)}`, digest };
}
