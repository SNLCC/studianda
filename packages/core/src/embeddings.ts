import { createHash } from 'node:crypto';
import type { SecretStore } from './secrets.js';
import type { Store } from './store.js';
import { resolveModelService } from './model-services.js';

export interface EmbeddingConfig {
  enabled: boolean;
  kind: 'external' | 'local';
  model: string;
  baseUrl?: string;
  apiKey?: string;
  provider?: string;
}

export interface EmbeddingStatus {
  chunks: number;
  vectors: number;
  model: string | null;
  external: boolean;
  configuredModel: string;
}

export interface EmbeddingIndexResult {
  indexed: number;
  model: string;
  external: boolean;
}

const LOCAL_MODEL = 'local-tfidf';

export function getEmbeddingConfig(store: Store, secrets: SecretStore): EmbeddingConfig {
  const routed = resolveModelService(store, secrets, 'embedding');
  if (routed) {
    return {
      enabled: true,
      kind: 'external',
      model: routed.model,
      baseUrl: routed.baseUrl,
      apiKey: routed.apiKey,
      provider: `${routed.baseUrl}|${routed.model}`
    };
  }
  // 环境变量覆盖：只给无界面运行与调试用。
  const baseUrl = process.env.STUDIANDA_EMBEDDING_BASE_URL?.trim();
  const model = process.env.STUDIANDA_EMBEDDING_MODEL?.trim();
  if (baseUrl && model) {
    const normalizedBase = baseUrl.replace(/\/+$/, '');
    return {
      enabled: true,
      kind: 'external',
      model,
      baseUrl: normalizedBase,
      apiKey:
        process.env.STUDIANDA_EMBEDDING_API_KEY?.trim() ||
        process.env.STUDIANDA_MODEL_API_KEY?.trim() ||
        '',
      provider: `${normalizedBase}|${model}`
    };
  }
  return { enabled: false, kind: 'local', model: LOCAL_MODEL };
}

async function externalEmbed(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
  if (!config.baseUrl) throw new Error('embedding 未配置');
  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
    },
    body: JSON.stringify({ model: config.model, input: texts }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`embedding 服务返回 ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ index?: number; embedding?: unknown[] }>;
  };
  if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
    throw new Error('Embedding count does not match input');
  }
  return payload.data
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((row) => {
      if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
        throw new Error('Invalid embedding');
      }
      return row.embedding.map((value) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid embedding');
        return value;
      });
    });
}

function cacheKey(provider: string, text: string): string {
  return createHash('sha256').update(`${provider}|${text}`).digest('hex');
}

/** provider+文本哈希缓存。 */
export async function vectorsFor(
  store: Store,
  secrets: SecretStore,
  texts: string[]
): Promise<number[][] | null> {
  const config = getEmbeddingConfig(store, secrets);
  if (!config.enabled || !config.provider) return null;

  const keys = texts.map((text) => cacheKey(config.provider as string, text));
  const cached = store.getEmbeddingCache(keys);
  const missing = [...new Set(keys.filter((key) => !cached.has(key)))];

  for (let index = 0; index < missing.length; index += 32) {
    const batch = missing.slice(index, index + 32);
    const byKey = new Map(keys.map((key, position) => [key, texts[position] ?? '']));
    const vectors = await externalEmbed(
      batch.map((key) => byKey.get(key) ?? ''),
      config
    );
    store.saveEmbeddingCache(
      batch.map((key, offset) => ({ key, vector: vectors[offset] ?? [] }))
    );
    for (const [key, vector] of batch.map((key, offset) => [key, vectors[offset] ?? []] as const)) {
      cached.set(key, vector as number[]);
    }
  }

  return keys.map((key) => cached.get(key) ?? []);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error('Embedding dimension mismatch; use a distinct model name');
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const norm = Math.sqrt(normA) * Math.sqrt(normB);
  return norm ? dot / norm : 0;
}

export interface SemanticChunk {
  id: string;
  text: string;
  documentId: string;
  page: number;
}

/** 语义排序：余弦相似度 + 页码邻近加成。 */
export async function semanticRank(
  store: Store,
  secrets: SecretStore,
  query: string,
  chunks: SemanticChunk[],
  documentId: string,
  page: number,
  mode: 'close' | 'wide',
  limit = 8
): Promise<Array<SemanticChunk & { score: number }>> {
  if (chunks.length === 0) return [];
  const vectors = await vectorsFor(store, secrets, chunks.map((chunk) => chunk.text));
  if (!vectors) return [];
  const queryVectors = await vectorsFor(store, secrets, [query]);
  if (!queryVectors) return [];
  const queryVector = queryVectors[0] ?? [];

  const results: Array<SemanticChunk & { score: number }> = [];
  chunks.forEach((chunk, index) => {
    const vector = vectors[index] ?? [];
    const score = cosine(queryVector, vector);
    if (score <= 0) return;
    const same = chunk.documentId === documentId;
    const bonus = same
      ? (mode === 'close' ? 0.08 : 0.02) / (1 + Math.abs(chunk.page - page))
      : 0;
    results.push({ ...chunk, score: Math.round((score + bonus) * 10000) / 10000 });
  });
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function embeddingStatus(store: Store, secrets: SecretStore): EmbeddingStatus {
  const config = getEmbeddingConfig(store, secrets);
  return {
    chunks: store.countChunks(),
    vectors: config.enabled ? store.countEmbeddingCache() : 0,
    model: config.enabled ? config.model : LOCAL_MODEL,
    external: config.enabled,
    configuredModel: config.model
  };
}

/** 外部 embedding 的缓存预热；本地 TF-IDF 在查询时计算，无需索引。 */
export async function indexChunks(
  store: Store,
  secrets: SecretStore,
  documentId?: string
): Promise<EmbeddingIndexResult> {
  const config = getEmbeddingConfig(store, secrets);
  if (!config.enabled) {
    return { indexed: 0, model: LOCAL_MODEL, external: false };
  }
  const chunks = store.listChunks(documentId).filter((chunk) => chunk.text.trim().length > 0);
  await vectorsFor(
    store,
    secrets,
    chunks.map((chunk) => chunk.text)
  );
  return { indexed: chunks.length, model: config.model, external: true };
}
