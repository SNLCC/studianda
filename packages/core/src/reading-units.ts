import type { ContentBlock, DocumentBlocks, DocumentSection } from '@studianda/shared';
import { cost as tokenCost } from './reading.js';

/**
 * 阅读单元：`decompose` 的产物，也是 `pack` 的输入。
 *
 * 一个单元是**连续的 block 区间**，它的边界只有两种来源：
 * - 文档自己的结构（节 / 子节）—— 切点落在标题处，论述边界天然完整；
 * - 无子结构的超长节里的硬切 —— 必须带 `splitReason`，让上层能如实说明"这里被切开了"。
 *
 * 单元不重叠、按 blockStart 递增；`pack` 只合并单元，**永不切开单元**。
 */
export interface ReadingUnit {
  /** 所属章节下标；`-1` 表示结构之外的尾部块。 */
  sectionIndex: number;
  title: string;
  blockStart: number;
  blockEnd: number;
  /** 闭区间的物理页范围，用于展示与回溯。 */
  pagesFrom: number;
  pagesTo: number;
  /** 该单元原文的 token 估算（与预算同口径）。 */
  cost: number;
  /** 该单元原文的字符数，用于覆盖率（不能用块数代替，否则比例会差一个数量级）。 */
  characters: number;
  /** 非结构切分时必须说明原因（'no_substructure'）。 */
  splitReason?: 'no_substructure';
}

export type CostFn = (text: string) => number;

export interface IntegrityReport {
  ok: boolean;
  issues: string[];
}

/**
 * 结构完整性校验（确定性，不含启发式）。
 *
 * 只查"能不能安全地拿节当装配边界"这一件事：
 * - 节区间单调、`blockStart <= blockEnd`；
 * - body 节之间**不重叠、不留空洞**；
 * - 每个 block 的 `section` 字段与覆盖它的区间自洽。
 *
 * **首尾允许无归属**：第一个节之前（封面/题名页）与最后一个节之后（参考文献/图注）
 * 本来就没有节，那不是缺陷——抽样核对时 5/5 样本都报"尾部空洞"，是我把判据写错了。
 */
export function checkIntegrity(blocks: ContentBlock[], sections: DocumentSection[]): IntegrityReport {
  const issues: string[] = [];
  const body = sections
    .filter((section) => section.kind === 'body')
    .slice()
    .sort((left, right) => left.blockStart - right.blockStart);

  let previous: DocumentSection | null = null;
  for (const section of body) {
    if (section.blockEnd < section.blockStart) {
      issues.push(`空节 s${section.index}`);
      continue;
    }
    if (section.blockStart < 0 || section.blockEnd >= blocks.length) {
      issues.push(`越界 s${section.index} (${section.blockStart}..${section.blockEnd})`);
      continue;
    }
    if (previous) {
      if (section.blockStart <= previous.blockEnd) {
        issues.push(`重叠 s${previous.index}→s${section.index}`);
      } else if (section.blockStart !== previous.blockEnd + 1) {
        issues.push(`空洞 s${previous.index}→s${section.index} (${previous.blockEnd + 1}..${section.blockStart - 1})`);
      }
    }
    previous = section;
  }

  for (const section of sections) {
    if (section.blockEnd < section.blockStart) continue;
    for (let index = section.blockStart; index <= Math.min(section.blockEnd, blocks.length - 1); index += 1) {
      const block = blocks[index];
      if (block && block.section !== section.index) {
        issues.push(`块 b${index} 的 section=${block.section} 与 s${section.index} 不一致`);
        break;
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export interface DecomposeOptions {
  /** 单个单元的原文预算（token）。超出则继续递归或硬切。 */
  budget: number;
  /** token 估算口径；默认与阅读链路一致（CJK 1.5 token/字）。 */
  cost?: CostFn;
  /** 硬切时相邻单元重叠的块数，保证跨切点的句子两侧都在。 */
  overlapBlocks?: number;
}

function blockText(blocks: ContentBlock[], start: number, end: number): string {
  const parts: string[] = [];
  for (let index = start; index <= end; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    const text = block.text.trim();
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

function pageRange(blocks: ContentBlock[], start: number, end: number): [number, number] {
  const first = blocks[start]?.page ?? 1;
  const last = blocks[end]?.page ?? first;
  return [Math.min(first, last), Math.max(first, last)];
}

/**
 * 把文档拆成能装进预算的阅读单元。
 *
 * 递归只用文档自己的结构（`DocumentSection.parent`），所以切点落在标题处；
 * 只有当一节**没有可用子节**时才硬切，并标 `splitReason`。
 * 硬切不受欢迎但必须存在——有些书就是 40 页一节、没有任何子标题。
 *
 * 尾部没有被任何节覆盖的块（参考文献、图注、附录尾巴）不会被丢掉：它们单独成单元。
 */
export function decompose(document: DocumentBlocks, options: DecomposeOptions): ReadingUnit[] {
  const { blocks, sections } = document;
  const cost = options.cost ?? tokenCost;
  const budget = Math.max(1, Math.floor(options.budget));
  const overlap = Math.max(0, Math.floor(options.overlapBlocks ?? 2));
  const units: ReadingUnit[] = [];
  const covered = new Uint8Array(blocks.length);

  const emit = (
    sectionIndex: number,
    title: string,
    start: number,
    end: number,
    splitReason?: 'no_substructure'
  ): void => {
    if (end < start) return;
    const [pagesFrom, pagesTo] = pageRange(blocks, start, end);
    const text = blockText(blocks, start, end);
    const unit: ReadingUnit = {
      sectionIndex,
      title,
      blockStart: start,
      blockEnd: end,
      pagesFrom,
      pagesTo,
      cost: cost(text),
      characters: text.length
    };
    if (splitReason) unit.splitReason = splitReason;
    units.push(unit);
    for (let index = start; index <= end; index += 1) covered[index] = 1;
  };

  const hardSplit = (section: DocumentSection, spanStart: number, spanEnd: number): void => {
    let start = spanStart;
    while (start <= spanEnd) {
      let end = start;
      let used = 0;
      while (end <= spanEnd) {
        const size = cost(blockText(blocks, end, end));
        if (end > start && used + size > budget) break;
        used += size;
        end += 1;
      }
      const last = Math.max(start, end - 1);
      emit(section.index, section.title, start, last, 'no_substructure');
      if (last >= spanEnd) break;
      // 相邻单元重叠若干块：跨切点的句子两侧都在，模型不会只看到半句。
      start = Math.max(start + 1, last + 1 - overlap);
    }
  };

  // 章节在数据模型里是"扁平铺开 + parent 指针"：父节的 blockEnd 在第一个子节处就被截断了，
  // 所以"一节的实际跨度"要沿子树求出来，不能直接用 section.blockEnd。
  const ordered = sections
    .filter((section) => section.blockEnd >= section.blockStart)
    .slice()
    .sort((left, right) => left.blockStart - right.blockStart);
  const childrenOf = new Map<number, DocumentSection[]>();
  for (const section of ordered) {
    if (section.parent === null) continue;
    const list = childrenOf.get(section.parent) ?? [];
    list.push(section);
    childrenOf.set(section.parent, list);
  }
  for (const list of childrenOf.values()) {
    list.sort((left, right) => left.blockStart - right.blockStart);
  }
  const subtreeEnd = new Map<number, number>();
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const section = ordered[index]!;
    let end = section.blockEnd;
    for (const child of childrenOf.get(section.index) ?? []) {
      end = Math.max(end, subtreeEnd.get(child.index) ?? child.blockEnd);
    }
    subtreeEnd.set(section.index, end);
  }

  const walk = (section: DocumentSection): void => {
    if (section.blockEnd < section.blockStart) return;
    const start = section.blockStart;
    const end = Math.max(section.blockEnd, subtreeEnd.get(section.index) ?? section.blockEnd);
    if (end < start) return;
    if (cost(blockText(blocks, start, end)) <= budget) {
      emit(section.index, section.title, start, end);
      return;
    }
    // 只沿文档结构向下：子节必须是当前跨度的真子集，否则会无限递归。
    const children = (childrenOf.get(section.index) ?? []).filter((child) => {
      if (child.blockStart < start) return false;
      const childEnd = subtreeEnd.get(child.index) ?? child.blockEnd;
      return childEnd <= end && childEnd - child.blockStart < end - start;
    });
    if (children.length > 0) {
      let cursor = start;
      for (const child of children) {
        const childEnd = subtreeEnd.get(child.index) ?? child.blockEnd;
        // 子节之间的空隙与节首的引言行：归到当前节，避免丢字。
        if (child.blockStart > cursor) emit(section.index, section.title, cursor, child.blockStart - 1);
        walk(child);
        cursor = Math.max(cursor, childEnd + 1);
      }
      if (cursor <= end) emit(section.index, section.title, cursor, end);
      return;
    }
    hardSplit(section, start, end);
  };

  const roots = ordered.filter(
    (section) =>
      section.parent === null || !ordered.some((item) => item.index === section.parent)
  );
  for (const root of roots) walk(root);

  // 没有任何节覆盖的尾部块：单独成单元，不因为"结构里没有它"就丢掉原文。
  let tailStart = -1;
  for (let index = 0; index < blocks.length; index += 1) {
    if (covered[index]) {
      if (tailStart >= 0) {
        emit(-1, '', tailStart, index - 1);
        tailStart = -1;
      }
      continue;
    }
    if (tailStart < 0) tailStart = index;
  }
  if (tailStart >= 0) emit(-1, '', tailStart, blocks.length - 1);

  units.sort((left, right) => left.blockStart - right.blockStart || left.blockEnd - right.blockEnd);
  return units;
}

export interface PackedBand {
  units: ReadingUnit[];
  cost: number;
  pages: number[];
}

export interface PackResult {
  bands: PackedBand[];
  coverage: {
    units: number;
    bands: number;
    /** 已装入单元的 block 区间（闭区间、按顺序）。 */
    blocksRead: Array<[number, number]>;
    /** 已装入单元占全部正文字数的比例（0..1）。 */
    readRatio: number;
  };
}

/**
 * 把单元装进若干"带"。
 *
 * 贪心装填、保持顺序、**永不切开单元**（单元本身已经保证 ≤ 预算）。
 * 全部装得下时就是一条带——这就是主路径：原文整段进最终回答的上下文。
 */
export function pack(
  units: readonly ReadingUnit[],
  budget: number,
  options: { totalCharacters?: number } = {}
): PackResult {
  const limit = Math.max(1, Math.floor(budget));
  const bands: PackedBand[] = [];
  let current: ReadingUnit[] = [];
  let used = 0;
  for (const unit of units) {
    if (current.length > 0 && used + unit.cost > limit) {
      bands.push({ units: current, cost: used, pages: bandPages(current) });
      current = [];
      used = 0;
    }
    current.push(unit);
    used += unit.cost;
  }
  if (current.length > 0) bands.push({ units: current, cost: used, pages: bandPages(current) });

  const blocksRead = units
    .map((unit) => [unit.blockStart, unit.blockEnd] as [number, number])
    .sort((left, right) => left[0] - right[0]);
  const readCharacters = units.reduce((total, unit) => total + unit.characters, 0);
  const totalCharacters = options.totalCharacters ?? readCharacters;
  return {
    bands,
    coverage: {
      units: units.length,
      bands: bands.length,
      blocksRead,
      readRatio: totalCharacters > 0 ? Math.min(1, readCharacters / totalCharacters) : 1
    }
  };
}

function bandPages(units: readonly ReadingUnit[]): number[] {
  const pages = new Set<number>();
  for (const unit of units) {
    for (let page = unit.pagesFrom; page <= unit.pagesTo; page += 1) pages.add(page);
  }
  return [...pages].sort((left, right) => left - right);
}
