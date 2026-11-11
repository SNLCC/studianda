/**
 * 库内检索问答的「命中片段」定位。
 *
 * 检索（`retrieval.retrieve`）仍然是原来的排序与命中页；这里只解决"命中之后给模型看什么"：
 * 从结构与内容块识别结果里找到命中词所在的**块**（自然段/列表项/题注…），
 * 再取该块所在的**章节级索引片段**。相比整页原文：
 * - 片段带章节标题，模型知道这段话出自哪一节；
 * - 片段不跨章节，避免把"方法"和"结果"塞进同一段上下文；
 * - 片段仍是原文文字（不是模型转述），引用与逐字核验口径不变。
 *
 * 找不到块（扫描页/校订页/识别失败）时返回 null，调用方退回整页原文，保持旧行为。
 */
import type {
  ContentBlock,
  DocumentBlocks,
  DocumentSection,
  DocumentSectionIndex,
  SearchHit,
  SectionIndexChunk
} from '@studianda/shared';
import { tokens } from './retrieval.js';
import type { Store } from './store.js';

export interface SectionContextInput {
  documentId: string;
  /** 命中页（引用跳转用）。 */
  page: number;
  /** 命中词所在整行（`SearchHit.match`）；没有时用 snippet。 */
  match?: string;
  snippet?: string;
}

export interface SectionContext {
  documentId: string;
  /** 命中位置所在页（引用跳转目标）。 */
  page: number;
  /** 片段覆盖到的最后一页。 */
  pageEnd: number;
  /** 所属章节下标；没有章节时为 -1。 */
  sectionIndex: number;
  sectionTitle: string;
  /** 命中的块 id/类别，便于审计"命中的是哪一段"。 */
  blockId: string;
  blockKind: ContentBlock['kind'];
  /** 送给模型的片段正文（章节标题 + 章节片段或块文字）。 */
  text: string;
}

/** 命中词落到的块与所属章节（不取片段正文，供检索结果/来源元数据用）。 */
export interface BlockSection {
  block: ContentBlock;
  section?: DocumentSection;
}

function textOfBlock(block: ContentBlock): string {
  return block.text.replace(/\s+/g, ' ').trim();
}

/** 命中词在块里的得分：整句命中优先，其次词面覆盖率。 */
function scoreBlock(block: ContentBlock, probe: string, probeTokens: Set<string>): number {
  const text = textOfBlock(block);
  if (!text) return 0;
  let score = 0;
  if (probe.length >= 4 && text.includes(probe)) score += 5;
  if (probe.length >= 2 && probe.includes(text) && text.length >= 2) score += 2;
  if (probeTokens.size > 0) {
    const blockTokens = new Set(tokens(text));
    let covered = 0;
    for (const token of probeTokens) if (blockTokens.has(token)) covered += 1;
    score += covered / probeTokens.size;
  }
  return score;
}

/**
 * 命中位置落在哪个块/哪一节：命中词在哪个块里，就取那个块（整句命中优先，其次词面覆盖率）。
 *
 * 页面上没有正文块、或命中词与任何块都不重合时返回 null（调用方应退回整页）。
 * 不读数据库、不调模型，纯计算。
 */
export function locateBlockSection(
  input: SectionContextInput,
  document: DocumentBlocks
): BlockSection | null {
  const pageBlocks = document.blocks.filter(
    (block) =>
      block.page === input.page && block.kind !== 'heading' && textOfBlock(block).length > 0
  );
  if (pageBlocks.length === 0) return null;

  const probe = (input.match ?? '').trim() || (input.snippet ?? '').trim();
  const probeTokens = new Set(tokens(probe));
  let best: ContentBlock | undefined;
  let bestScore = 0;
  for (const block of pageBlocks) {
    const score = scoreBlock(block, probe, probeTokens);
    if (score > bestScore) {
      best = block;
      bestScore = score;
    }
  }
  if (!best) return null;
  const chosen = best;
  const section =
    chosen.section < 0
      ? undefined
      : document.sections.find((item) => item.index === chosen.section);
  return { block: chosen, section };
}

/** 找到覆盖该块的章节片段；找不到时返回 null（调用方退回块文字）。 */
function chunkForBlock(
  index: DocumentSectionIndex | undefined,
  section: DocumentSection | undefined,
  block: ContentBlock
): SectionIndexChunk | undefined {
  if (!index || !section) return undefined;
  const candidates = index.chunks.filter((chunk) => chunk.section === section.index);
  if (candidates.length === 0) return undefined;
  const blockText = textOfBlock(block);
  const direct = candidates.find((chunk) => chunk.text.includes(blockText));
  if (direct) return direct;
  const covering = candidates
    .filter((chunk) => chunk.page <= block.page && block.page <= chunk.pageEnd)
    .sort((left, right) => left.pageEnd - left.page - (right.pageEnd - right.page));
  if (covering.length > 0) return covering[0];
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate.page - block.page) < Math.abs(best.page - block.page) ? candidate : best
  );
}

/**
 * 为一次检索命中定位"命中片段"。
 *
 * 返回 null 表示识别不出可用片段（没有块、命中词与任何块都不重合），调用方应退回整页原文。
 */
export function locateSectionContext(
  input: SectionContextInput,
  document: DocumentBlocks,
  index?: DocumentSectionIndex
): SectionContext | null {
  const found = locateBlockSection(input, document);
  if (!found) return null;
  const { block: best, section } = found;
  const chunk = chunkForBlock(index, section, best);
  const fallbackText = section?.title
    ? `${section.title}\n${textOfBlock(best)}`
    : textOfBlock(best);
  return {
    documentId: input.documentId,
    page: input.page,
    pageEnd: Math.max(input.page, chunk?.pageEnd ?? best.page),
    sectionIndex: section?.index ?? -1,
    sectionTitle: section?.title ?? '',
    blockId: best.id,
    blockKind: best.kind,
    text: chunk?.text ?? fallbackText
  };
}

/**
 * 给检索结果补章节元数据（`sectionTitle`/`blockId`），供检索结果列表显示"命中在哪一节"。
 *
 * 只使用**已就绪**的内容块缓存（`Store.peekDocumentBlocks`）：不会为了搜索结果去解析整篇 PDF，
 * 因此首次检索可能没有章节信息（缺省），不会拖慢搜索。`warm: true` 时对缺失的文献在后台
 * 触发一次识别，下一次检索就能带上章节（不阻塞本次响应）。
 */
export async function annotateSearchHits(
  store: Store,
  hits: SearchHit[],
  options: { warm?: boolean } = {}
): Promise<SearchHit[]> {
  if (hits.length === 0) return hits;
  const documents = new Map<string, DocumentBlocks | null>();
  const missing = new Set<string>();
  const blocksOf = (documentId: string): DocumentBlocks | null => {
    if (!documents.has(documentId)) {
      const cached = store.peekDocumentBlocks(documentId);
      documents.set(documentId, cached);
      if (!cached) missing.add(documentId);
    }
    return documents.get(documentId) ?? null;
  };
  const annotated = hits.map((hit) => {
    const blocks = blocksOf(hit.documentId);
    if (!blocks) return hit;
    const found = locateBlockSection(hit, blocks);
    if (!found) return hit;
    return {
      ...hit,
      blockId: found.block.id,
      ...(found.section?.title ? { sectionTitle: found.section.title } : {})
    };
  });
  if (options.warm) {
    // 只预热少量文献：搜索是高频操作，不能因为补章节元数据把整库 PDF 都解析一遍。
    let warmed = 0;
    for (const documentId of missing) {
      if (warmed >= 3) break;
      warmed += 1;
      // 后台预热：结果不用于本次响应；失败不影响检索（下次会再试）。
      void store.getDocumentBlocks(documentId).catch(() => undefined);
    }
  }
  return annotated;
}
