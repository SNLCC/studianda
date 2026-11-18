/**
 * 读后缺口检索：判断「这一页里还找不找得到问题里的东西」。
 *
 * 原先的实现是整页文本上的 `pageText.includes(term)`。它有两个问题：
 * 1. 中文几乎必然漏判：问「叙事策略」，正文写成「……的叙事，其策略……」就匹配不上，
 *    于是本可以补读的页被当成「不相关」，`answerability` 的 searched 口径随之失真；
 * 2. 反过来，`includes` 对英文又是「子串」语义，短词容易假阳性。
 *
 * 这里复用检索栈自己的分词口径（英文/数字词 + 中文双字，见 retrieval-tokens.ts），
 * 把判定改成「词项覆盖率」：
 * - 覆盖率门槛（≥2/3）允许中文换一种断句，但不允许只撞上一个二字词；
 * - 打分只用于给补读页排序，不参与门槛判断，因此阈值不随语料规模漂移。
 *
 * 纯本机计算：不读密钥、不发网络请求，与模型/embedding 配置无关——这一点是硬约束，
 * 缺口检索一旦联网就会改变「默认不外发」的既有数据流声明。
 */
import type { ChunkRow } from './retrieval.js';
import { retrieve, tokens } from './retrieval.js';
import { getEmbeddingConfig } from './embeddings.js';
import type { SecretStore } from './secrets.js';
import type { Store } from './store.js';

/** 命中门槛：至少覆盖该词项 2/3 的分词单元。 */
const COVERAGE_NUM = 2;
const COVERAGE_DEN = 3;

export interface GapPageHit {
  page: number;
  /** 排序用分值：命中词项的覆盖率之和，越大越相关。 */
  score: number;
  /** 该页最高的一条词项覆盖率（0–1），用于诊断。 */
  coverage: number;
  /** 该页命中的查询词项，用于诊断与测试。 */
  terms: string[];
}

interface TermKeys {
  term: string;
  keys: string[];
}

/**
 * 问题术语 + 规划查询词：中文 2–6 字、英文 3 字以上，去重（忽略大小写）后保序。
 * 与改造前 question-match 的正则保持一致，只是把「取术语」这件事收进一处。
 */
export function gapSearchTerms(
  question: string,
  queries: readonly string[] = []
): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const candidates = [
    ...(question.match(/[\u3400-\u9fff]{2,6}|[A-Za-z]{3,}/g) ?? []),
    ...queries
  ];
  for (const raw of candidates) {
    const term = raw.trim();
    if (term.length < 2) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

function termKeysOf(terms: readonly string[]): TermKeys[] {
  const out: TermKeys[] = [];
  for (const term of terms) {
    const keys = [...new Set(tokens(term))].filter((key) => key.length >= 2);
    if (keys.length > 0) out.push({ term, keys });
  }
  return out;
}

/** 单页覆盖率：取所有词项中覆盖最高的那一条。 */
function coverageOf(text: string, termKeys: readonly TermKeys[]): {
  coverage: number;
  terms: string[];
  score: number;
} {
  const present = new Set(tokens(text));
  let best = 0;
  let score = 0;
  const hit: string[] = [];
  for (const entry of termKeys) {
    let matched = 0;
    for (const key of entry.keys) if (present.has(key)) matched += 1;
    if (matched === 0) continue;
    // 门槛：matched / keys >= 2/3，用整数比较避免浮点误差。
    if (matched * COVERAGE_DEN < entry.keys.length * COVERAGE_NUM) continue;
    const coverage = matched / entry.keys.length;
    if (coverage > best) best = coverage;
    score += coverage;
    hit.push(entry.term);
  }
  return { coverage: best, terms: hit, score };
}

/**
 * 从 chunks 里找出「与查询词项足够相关」的页，按相关度降序。
 * chunks 通常来自 `gapChunkRows`；测试里可以直接构造。
 */
export function gapPageHits(
  chunks: readonly ChunkRow[],
  terms: readonly string[],
  options: { limit?: number } = {}
): GapPageHit[] {
  if (chunks.length === 0 || terms.length === 0) return [];
  const termKeys = termKeysOf(terms);
  if (termKeys.length === 0) return [];
  const limit = options.limit ?? 200;
  const byPage = new Map<number, GapPageHit>();
  for (const chunk of chunks) {
    const { coverage, terms: hitTerms, score } = coverageOf(chunk.text, termKeys);
    if (hitTerms.length === 0) continue;
    const existing = byPage.get(chunk.page);
    if (!existing) {
      byPage.set(chunk.page, { page: chunk.page, score, coverage, terms: hitTerms });
      continue;
    }
    existing.score += score;
    existing.coverage = Math.max(existing.coverage, coverage);
    for (const term of hitTerms) {
      if (!existing.terms.includes(term)) existing.terms.push(term);
    }
  }
  return [...byPage.values()]
    .sort((left, right) => right.score - left.score || left.page - right.page)
    .slice(0, limit);
}

/**
 * 取检索用的 chunk 行。
 *
 * 正常情况下直接用库里的 chunks；没有 chunk 的文献（例如只做了页文本、尚未切块的导入）
 * 用页文本合成一份等价行，保证缺口检索在两条路径上口径一致。
 */
export function gapChunkRows(
  store: Store,
  documentId: string,
  pages: readonly number[]
): ChunkRow[] {
  const chunks = store.listChunks(documentId);
  if (chunks.length > 0) {
    return chunks.map((chunk) => ({
      id: chunk.id,
      documentId: chunk.documentId,
      page: chunk.page,
      text: chunk.text,
      name: ''
    }));
  }
  return pages.map((page) => ({
    id: `page-${page}`,
    documentId,
    page,
    text: store.getPageText(documentId, page),
    name: ''
  }));
}

/** 合并候选页：词法命中在前，语义命中只补词法没有给出的页。 */
export function mergeGapCandidates(
  lexicalPages: readonly number[],
  semanticPages: readonly number[],
  limit: number
): number[] {
  const seen = new Set<number>();
  const merged: number[] = [];
  for (const page of [...lexicalPages, ...semanticPages]) {
    if (seen.has(page)) continue;
    seen.add(page);
    merged.push(page);
    if (merged.length >= limit) break;
  }
  return merged;
}

/**
 * 补读候选页：词法优先；**词法一个都没找到**时才用语义兜底。
 *
 * 语义只在"召回真空"时兜底，而不是每次都跑，有两个原因：
 * 1. 配置了远程 embedding 时，语义检索会把该文献的 chunk 送上网络（首次全量、之后走
 *    `embedding_cache`）。只在词法空手而归时触发，能把网络与费用控制在真正的失败场景里，
 *    也不会把"默认不外发"变成"每问一句都外发"；
 * 2. 语义相似度阈值随模型与语料漂移，不适合当作"还有没有未读命中页"的判据——那件事仍然
 *    只由词法覆盖率回答（见 reading-chat 的 remainingGapHits）。
 */
export async function gapSelectionPages(
  store: Store,
  secrets: SecretStore | undefined,
  documentId: string,
  terms: readonly string[],
  options: { anchorPage?: number; limit?: number; pages?: readonly number[] } = {}
): Promise<{ pages: number[]; semantic: boolean }> {
  const limit = options.limit ?? 40;
  const lexicalPages = gapPageHits(
    gapChunkRows(store, documentId, options.pages ?? []),
    terms
  ).map((hit) => hit.page);
  if (lexicalPages.length > 0 || terms.length === 0) {
    return { pages: mergeGapCandidates(lexicalPages, [], limit), semantic: false };
  }
  if (!secrets) return { pages: [], semantic: false };
  const config = getEmbeddingConfig(store, secrets);
  if (!config.enabled) return { pages: [], semantic: false };
  try {
    const hits = await retrieve(
      store,
      secrets,
      terms.join(' '),
      documentId,
      options.anchorPage ?? 1,
      'wide',
      limit,
      { includeDerived: false }
    );
    return {
      pages: mergeGapCandidates(
        [],
        hits.map((hit) => hit.page),
        limit
      ),
      semantic: true
    };
  } catch {
    // 语义兜底失败不影响回答：退回"没有补读候选"，由审计与覆盖账兜住。
    return { pages: [], semantic: false };
  }
}
