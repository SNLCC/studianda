import type { SecretStore } from './secrets.js';
import type { Store } from './store.js';
import { getEmbeddingConfig, semanticRank } from './embeddings.js';
import { oppositeQueries } from './falsify.js';
import { pickPages } from './semantic.js';

export interface SemanticReverseResult {
  enabled: boolean;
  pages: number[];
  queries: string[];
  warning?: string;
}

/**
 * 证伪检索的语义反向召回：用“X 的反面/限定/质疑”去向量检索，
 * 抓没有转折标记、但整段在讲反面的页。未启用 embedding 时不调用外部服务。
 */
export async function semanticReversePages(
  store: Store,
  secrets: SecretStore,
  documentId: string,
  original: string,
  alreadyPlanned: Set<number>,
  currentPage = 1,
  limit = 8
): Promise<SemanticReverseResult> {
  const config = getEmbeddingConfig(store, secrets);
  if (!config.enabled) {
    return { enabled: false, pages: [], queries: [], warning: '未启用 embedding，跳过语义反向召回' };
  }
  const queries = oppositeQueries([], original, 2);
  if (queries.length === 0) {
    return { enabled: true, pages: [], queries: [] };
  }
  const chunks = store.listChunks(documentId).map((chunk) => ({
    id: chunk.id,
    text: chunk.text,
    documentId: chunk.documentId,
    page: chunk.page
  }));
  const pages = new Set<number>();
  try {
    for (const query of queries) {
      const ranked = await semanticRank(
        store,
        secrets,
        query,
        chunks,
        documentId,
        currentPage,
        'wide',
        12
      );
      const scores = new Map<number, number>();
      for (const row of ranked) scores.set(row.page, row.score);
      for (const page of pickPages(scores, 8)) {
        if (!alreadyPlanned.has(page)) pages.add(page);
      }
    }
  } catch (error) {
    return {
      enabled: true,
      pages: [],
      queries,
      warning: error instanceof Error ? error.message : '语义反向召回失败'
    };
  }
  return {
    enabled: true,
    pages: [...pages].sort((left, right) => left - right).slice(0, limit),
    queries
  };
}
