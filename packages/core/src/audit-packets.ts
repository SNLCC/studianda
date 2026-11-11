import { cost } from './reading.js';
import { rank } from './retrieval.js';

/**
 * 本地、可追溯的原文片段包，用于「论断是否有原文支持」的核对。
 *
 * 这一层只核对**被引用处**的支持依据，
 * 不做全书穷尽核查；所有摘录保持逐字并绑定原来源编号。它不读文件、不调模型。
 *
 * 为什么需要它（用户可见的失败方式）：核对调用如果只把「整篇回答 + 全部来源编号」发出去，
 * 模型要么看不到原文、只能凭印象判 supported，要么被要求抄一大堆与论断无关的原文。
 * 这里按「这条论断引用了哪个来源」挑出**最相关的一小段原文**，让判定有据、让代价可控。
 */

/** 一条待核对的原始来源（同时兼容 snake_case 与 camelCase 字段名）。 */
export interface AuditOriginal {
  text?: string;
  document_id?: string;
  documentId?: string;
  page?: number;
  source_type?: string;
  sourceType?: string;
}

/** 一条被选中的逐字片段；`evidence_key` 是这一包内的稳定指认（E1、E2……）。 */
export interface AuditPacketEvidence {
  source: number;
  quote: string;
  evidence_key: string;
  offset_start: number;
  offset_end: number;
  source_type: string;
}

export interface AuditPacketSelection {
  /** 交给核对调用的材料：`{"verified_quotes":[...]}`（只有逐字片段，没有派生分析）。 */
  context: string;
  /** `evidence_key → 片段`，核对可以只指认 key 而不重抄原文。 */
  index: Record<string, AuditPacketEvidence>;
  report: {
    mode: string;
    available_passages: number;
    selected_passages: number;
    sources: number[];
  };
}

/** 固定的切片宽度与重叠量；重叠保证跨片段的限定条件不会被切断。 */
const DEFAULT_WIDTH = 600;
const DEFAULT_OVERLAP = 150;
const MODE = '按论断选取原文片段，非全书穷尽核查';

/** 内部使用的片段：id 是**补零的序号**，因此按字符串比较就等于按生成顺序比较。 */
interface PacketChunk {
  id: string;
  documentId: string;
  page: number;
  text: string;
  name: string;
  source: number;
  start: number;
  end: number;
  sourceType: string;
}

function chunkIndex(chunk: { id: string }): number {
  return Number.parseInt(chunk.id, 10);
}

function rowDocumentId(row: AuditOriginal): string {
  return row.document_id ?? row.documentId ?? '';
}

function rowSourceType(row: AuditOriginal): string {
  return row.source_type ?? row.sourceType ?? 'document';
}

/**
 * 把一段原文切成带偏移的连续片段。
 *
 * 边界优先落在换行或中文句号之后（从 `start+width/2` 起找，避免切出极短的尾巴）；
 * 切不动就按 `width` 硬切。`overlap` 让相邻片段共享一段原文——限定条件常常跨在边界上。
 */
export function passages(
  text: string,
  width = DEFAULT_WIDTH,
  overlap = DEFAULT_OVERLAP
): Array<[number, number, string]> {
  const result: Array<[number, number, string]> = [];
  const body = text ?? '';
  let start = 0;
  while (start < body.length) {
    let end = Math.min(body.length, start + width);
    if (end < body.length) {
      // 只在 [start+width//2, end) 内找换行或句号，找不到就按固定宽度切开。
      const lower = start + Math.floor(width / 2);
      const newline = body.lastIndexOf('\n', end - 1);
      const period = body.lastIndexOf('。', end - 1);
      const boundary = Math.max(newline >= lower ? newline : -1, period >= lower ? period : -1);
      if (boundary >= 0) end = boundary + 1;
    }
    result.push([start, end, body.slice(start, end)]);
    if (end === body.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return result;
}

function extractCitations(text: string): Set<number> {
  const numbers = new Set<number>();
  for (const match of (text ?? '').matchAll(/\[(\d+)\]/g)) {
    const value = Number.parseInt(match[1] ?? '', 10);
    if (Number.isInteger(value)) numbers.add(value);
  }
  return numbers;
}

/**
 * 按论断挑出原文片段。
 *
 * 候选顺序刻意分三层，缺一层就会退化成「谁分数高谁进包」：
 * 1. **被引用的来源优先**：每条被引用来源先得到一个种子片段，避免某一条长来源把包占满；
 * 2. **逐行锚点**：回答里不同段落可能引用同一页的不同部位，按行再做一次检索；
 * 3. **相邻片段**：同一来源内相邻片段保留就近的限定条件/条件句。
 *
 * 最后由 `budget` 卡住：按候选顺序一个个尝试加入，装不下就停——
 * **不静默超容量，也不让模型自己挑**。
 */
export function select(
  answer: string,
  originals: AuditOriginal[],
  allowed: ReadonlySet<number>,
  budget: number
): AuditPacketSelection {
  const chunks: PacketChunk[] = [];
  const allowedNumbers = [...allowed].filter((source) => Number.isInteger(source));
  const cited = new Set([...extractCitations(answer)].filter((source) => allowed.has(source)));

  for (const source of [...allowedNumbers].sort((left, right) => left - right)) {
    if (source < 1 || source > originals.length) continue;
    const row = originals[source - 1];
    if (!row) continue;
    for (const [start, end, text] of passages(row.text ?? '')) {
      chunks.push({
        id: String(chunks.length).padStart(6, '0'),
        documentId: rowDocumentId(row),
        page: row.page ?? 0,
        text,
        name: '',
        source,
        start,
        end,
        sourceType: rowSourceType(row)
      });
    }
  }
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));

  // document_id 传空串：页码邻近加成恒不生效，得分就是纯词面相关度（wide 口径）。
  const ranked = rank(answer, chunks, '', 0, 'wide', chunks.length);
  const scores = new Map(ranked.map((row) => [row.id, row.score]));
  const ordered = [...chunks].sort((left, right) => {
    const leftCited = cited.has(left.source) ? 0 : 1;
    const rightCited = cited.has(right.source) ? 0 : 1;
    if (leftCited !== rightCited) return leftCited - rightCited;
    const delta = (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0);
    if (delta !== 0) return delta;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  // 每条被引用来源先拿到一次机会（顺序 = 上面 ordered 的顺序）。
  const seeds: PacketChunk[] = [];
  const seenSources = new Set<number>();
  for (const row of ordered) {
    if (cited.has(row.source) && !seenSources.has(row.source)) {
      seeds.push(row);
      seenSources.add(row.source);
    }
  }

  // 每行引用分别做一次锚点检索：同一页的不同部位可能支持不同论断。
  const anchors: PacketChunk[] = [];
  for (const line of (answer ?? '').split(/\r?\n/)) {
    const ids = new Set([...extractCitations(line)].filter((source) => allowed.has(source)));
    if (ids.size === 0) continue;
    const lineChunks = chunks.filter((chunk) => ids.has(chunk.source));
    for (const hit of rank(line, lineChunks, '', 0, 'wide', 1)) {
      const row = byId.get(hit.id);
      if (row) anchors.push(row);
    }
  }

  const candidates: PacketChunk[] = [];
  const seen = new Set<string>();
  const add = (row: PacketChunk): void => {
    if (seen.has(row.id)) return;
    candidates.push(row);
    seen.add(row.id);
  };
  // 所有被引用来源都先轮到，再轮到任何来源的相邻片段。
  for (const row of [...seeds, ...anchors]) add(row);

  const rankedRows = ranked
    .slice(0, Math.max(2, cited.size))
    .map((hit) => byId.get(hit.id))
    .filter((row): row is PacketChunk => Boolean(row));
  for (const row of [...seeds, ...anchors, ...rankedRows, ...ordered]) {
    add(row);
    const index = chunkIndex(row);
    for (const position of [index - 1, index + 1]) {
      if (position < 0 || position >= chunks.length) continue;
      const neighbor = chunks[position];
      if (neighbor && neighbor.source === row.source) add(neighbor);
    }
  }

  const bank: AuditPacketEvidence[] = [];
  for (const row of candidates) {
    const item: AuditPacketEvidence = {
      source: row.source,
      quote: row.text,
      evidence_key: `E${bank.length + 1}`,
      offset_start: row.start,
      offset_end: row.end,
      source_type: row.sourceType
    };
    const candidate = JSON.stringify({ verified_quotes: [...bank, item] });
    if (cost(candidate) <= budget) bank.push(item);
  }

  return {
    context: JSON.stringify({ verified_quotes: bank }),
    index: Object.fromEntries(bank.map((item) => [item.evidence_key, item])),
    report: {
      mode: MODE,
      available_passages: chunks.length,
      selected_passages: bank.length,
      sources: [...new Set(bank.map((item) => item.source))].sort((left, right) => left - right)
    }
  };
}
